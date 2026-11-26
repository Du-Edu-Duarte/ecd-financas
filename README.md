# ECD Finanças

**Fluxo de caixa, contas a pagar e receber, cartões, metas e relatórios** para pequenas empresas, com modo pessoal / família também. Mostra o que entra, o que sai e o que sobra, hoje e nos próximos meses.

**Demonstração:** https://du-edu-duarte.github.io/ecd-financas/

> Versão de demonstração com valores fictícios. Tudo fica salvo apenas no navegador de quem está usando.

## O que ele faz

1. **Painel com gráfico e previsão.** Entradas x saídas dos últimos 6 meses, saldo no fim de cada mês e previsão para os próximos 3 meses.
2. **Situação clara.** A vencer, vence hoje, atrasado e pago. Ao confirmar, você informa a data e o valor real, com juros ou desconto.
3. **Metas e reservas.** Barra de progresso e quanto guardar por mês para chegar no prazo.
4. **Limite por categoria.** Avisa quando o gasto passa de 80% do limite e quando estoura.
5. **Parcelas e cartão de crédito.** Compra em várias vezes, fatura com fechamento e vencimento, e limite usado.
6. **Importar extrato do banco.** Aceita OFX ou CSV, escolhe a categoria por regras (ex.: "uber" vira transporte) e marca o que parece já lançado.
7. **Comprovantes.** Foto ou PDF anexado em cada lançamento.
8. **Relatórios.** Resultado do mês (DRE simplificado), gastos por categoria, centro de custo, cliente e fornecedor, com exportação em **PDF** e **Excel (CSV)**.
9. **Modo empresa ou pessoal.** Clientes, fornecedores e centros de custo, ou o planejamento da família.
10. **Acesso com aprovação.** Login com e-mail e senha (criptografada com PBKDF2), cadastro complementar (setor, WhatsApp e campos extras configuráveis) e aprovação do administrador: o pedido chega por e-mail e a liberação é um link assinado digitalmente (Ed25519), que não pode ser falsificado. Funciona no celular e pode ser **instalado como app**.
11. **Lê o comprovante sozinho.** Anexe o PDF (ou a foto) do Pix, transferência ou boleto: o sistema identifica se é entrada ou saída, o valor, a data, quem pagou ou recebeu e sugere a categoria.
12. **Cria na hora o que faltar.** Toda lista de categoria, cliente, fornecedor e centro de custo tem “+ Nova…”, sem sair do lançamento.
13. **Começar do zero.** Quem é aprovado escolhe entre explorar os exemplos ou começar com o próprio dinheiro, com categorias pessoais prontas.

Tem ainda a opção **preto e branco**, no menu do usuário, que vale para todos os sistemas ECD.

## Tecnologias

| | |
| --- | --- |
| Interface | HTML, CSS e JavaScript puro, com gráfico em SVG próprio |
| PDF | [pdf-lib](https://pdf-lib.js.org/) |
| Dados | IndexedDB (no navegador) |
| App instalável | Manifest + Service Worker |
| Hospedagem | GitHub Pages |

## Estrutura

```
index.html            # estrutura
style.css · fin.css   # visual ECD + telas de finanças
app.js                # regras (caixa, faturas, previsão), telas, relatórios e importação
comprovante.js        # leitura de comprovantes (pdf.js e OCR)
ecd-auth.js           # login com senha, cadastro, aprovação assinada e tema (compartilhado)
sw.js · manifest      # app instalável e uso sem internet
```

## Rodar localmente

```bash
python3 -m http.server 8000
```

## Versão para empresas

Na versão para empresas, os dados ficam num servidor com login de verdade (por exemplo, Supabase). A equipe inteira vê o mesmo caixa em qualquer aparelho, e o sistema pode lembrar os vencimentos por e-mail ou WhatsApp.

## Autor

**Eduardo Costa Duarte** · [ECD Tecnologia](https://www.instagram.com/ecdtecnologia/) · [LinkedIn](https://www.linkedin.com/in/eduardo-costa-0a0b462a8)
